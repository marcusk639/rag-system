// Unit-test projects only. tests/e2e is excluded (requires Docker) and runs
// via `pnpm e2e`; examples/ are not part of the quality gate.
export default ["packages/*", "apps/*"];
