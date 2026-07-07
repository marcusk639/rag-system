import "next-auth";

declare module "next-auth" {
  interface Session {
    /** The signed-in user's stable AAD object id. */
    oid: string;
    /** AAD security group claim values, when present (see hasGroupsOverage). */
    groups?: string[];
    /** True when Entra ID omitted inline groups due to "groups overage". */
    hasGroupsOverage: boolean;
  }
}
