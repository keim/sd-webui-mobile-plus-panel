// Bundled-asset imports (used by mockCore.ts for the mock
// fixtures). Bun.build emits these as files under assets/ and
// the import evaluates to their URL.
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.jpg" {
  const url: string;
  export default url;
}
