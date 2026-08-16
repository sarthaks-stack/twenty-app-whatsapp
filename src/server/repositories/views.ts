import type { FieldDescriptor, ViewFilterGroupRow, ViewFilterRow } from '../../domain/campaign/view-filter';
import { metadataClient } from '../clients';
import { describeError, logger } from '../logger';

/**
 * Reading a saved view (FR-CAM-2a).
 *
 * Views live in the **Metadata** API, not the Core one: a view is a saved set
 * of filters over a field metadata id, and the Core API has never heard of it.
 * So an audience defined by a view is assembled here — the view, its filters,
 * its filter groups and the field metadata they refer to — and translated by
 * the pure module before a single Person is read.
 *
 * The field map is what makes the translation possible at all: a `viewFilter`
 * names `fieldMetadataId`, and the Core filter needs `jobTitle`. Without the
 * map the filter is a UUID pointing at nothing.
 */

export type ViewSummary = {
  id: string;
  name: string;
  objectMetadataId: string;
};

export const findView = async (viewId: string): Promise<ViewSummary | null> => {
  try {
    const result = await metadataClient().query({
      getView: {
        __args: { id: viewId },
        id: true,
        name: true,
        objectMetadataId: true,
      },
    });

    const view = result.getView;

    return view === null || view === undefined
      ? null
      : {
          id: view.id as string,
          name: (view.name as string) ?? '',
          objectMetadataId: view.objectMetadataId as string,
        };
  } catch (error) {
    logger.warn('views.lookup_failed', { viewId, ...describeError(error) });

    return null;
  }
};

export const listViewFilters = async (viewId: string): Promise<ViewFilterRow[]> => {
  const result = await metadataClient().query({
    getViewFilters: {
      __args: { viewId },
      id: true,
      fieldMetadataId: true,
      operand: true,
      value: true,
      viewFilterGroupId: true,
      positionInViewFilterGroup: true,
      subFieldName: true,
    },
  });

  return (result.getViewFilters ?? []).map((filter) => ({
    id: filter.id as string,
    fieldMetadataId: filter.fieldMetadataId as string,
    operand: String(filter.operand),
    value: filter.value,
    viewFilterGroupId: filter.viewFilterGroupId ?? null,
    positionInViewFilterGroup: filter.positionInViewFilterGroup ?? null,
    subFieldName: filter.subFieldName ?? null,
  }));
};

export const listViewFilterGroups = async (
  viewId: string,
): Promise<ViewFilterGroupRow[]> => {
  const result = await metadataClient().query({
    getViewFilterGroups: {
      __args: { viewId },
      id: true,
      logicalOperator: true,
      parentViewFilterGroupId: true,
      positionInViewFilterGroup: true,
    },
  });

  return (result.getViewFilterGroups ?? []).map((group) => ({
    id: group.id as string,
    logicalOperator: String(group.logicalOperator),
    parentViewFilterGroupId: group.parentViewFilterGroupId ?? null,
    positionInViewFilterGroup: group.positionInViewFilterGroup ?? null,
  }));
};

/**
 * Field metadata id → the Core field it names, for one object.
 *
 * Not cached. The metadata-id cache exists for identifiers that never change
 * for an installed app; a workspace's *own* fields change whenever someone
 * adds one, and a stale map would silently drop the newest filter from an
 * audience — the failure this whole path is written to avoid.
 */
export const fieldsForObject = async (
  objectMetadataId: string,
): Promise<Map<string, FieldDescriptor>> => {
  const result = await metadataClient().query({
    objects: {
      __args: { paging: { first: 500 }, filter: {} },
      edges: {
        node: {
          id: true,
          fields: {
            __args: { paging: { first: 500 }, filter: {} },
            edges: { node: { id: true, name: true, type: true } },
          },
        },
      },
    },
  });

  const object = (result.objects.edges ?? [])
    .map((edge) => edge.node)
    .find((node) => node.id === objectMetadataId);

  return new Map(
    (object?.fields?.edges ?? [])
      .map((edge) => edge.node)
      .filter((node) => typeof node?.id === 'string' && typeof node?.name === 'string')
      .map((node): [string, FieldDescriptor] => [
        node.id,
        { name: node.name, type: String(node.type) },
      ]),
  );
};

/**
 * The saved Person views a campaign can target (FR-CAM-2a, specs/07 §2 step 3).
 *
 * `getViews` returns more than a person would call a view: Twenty stores a
 * record page's field layout as one too — `FIELDS_WIDGET` — and offering
 * "Person Record Page Fields" as an audience would be offering a layout as a
 * list of people.
 *
 * The filter is an **allow-list**, so a view type Twenty adds later is left out
 * until someone decides it belongs. The two failure directions are not
 * symmetric: omitting a real view means an admin cannot pick it, while
 * including a layout means sending a campaign to whatever it happens to
 * translate into.
 *
 * The index view ("All People") is deliberately included: everyone is a
 * legitimate audience, chosen deliberately, and the pre-flight panel is where
 * that choice is confronted with its own size.
 */
export const AUDIENCE_VIEW_TYPES = new Set(['TABLE', 'KANBAN', 'CALENDAR']);

export const listPersonViews = async (
  personObjectMetadataId: string,
): Promise<ViewSummary[]> => {
  try {
    const result = await metadataClient().query({
      getViews: {
        __args: { objectMetadataId: personObjectMetadataId },
        id: true,
        name: true,
        objectMetadataId: true,
        type: true,
        key: true,
      },
    });

    const views = (result.getViews ?? []) as {
      id?: string;
      name?: string;
      objectMetadataId?: string;
      type?: string | null;
    }[];

    return views
      .filter(
        (view) =>
          typeof view.id === 'string' &&
          view.objectMetadataId === personObjectMetadataId &&
          typeof view.type === 'string' &&
          AUDIENCE_VIEW_TYPES.has(view.type),
      )
      .map((view) => ({
        id: view.id!,
        name: view.name ?? '',
        objectMetadataId: view.objectMetadataId!,
      }));
  } catch (error) {
    logger.warn('views.list_failed', describeError(error));

    return [];
  }
};
