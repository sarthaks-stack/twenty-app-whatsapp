/**
 * Side-effect CSS imports.
 *
 * `twenty-ui` ships its components' styles as CSS modules and its stylesheet as
 * a subpath export with no type declaration, so `import 'twenty-ui/style.css'`
 * is a type error while being *required* at runtime: without it every shared
 * `twenty-ui` component renders unstyled inside a front component, which is a
 * failure nobody sees until the widget is on screen.
 *
 * So the import stays and the missing declaration is supplied here. Declared
 * narrowly — a bare module with no exports — because that is exactly what a
 * stylesheet is to the type system, and a `*` wildcard would also silence a
 * genuinely mistyped import of a real module.
 */

declare module '*.css';
