import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    MicrosoftEntraID({
      clientId: process.env.AUTH_ENTRA_CLIENT_ID!,
      clientSecret: process.env.AUTH_ENTRA_CLIENT_SECRET!,
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_ENTRA_TENANT_ID}/v2.0`,
      authorization: {
        params: { scope: "openid profile email offline_access" },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, profile }) {
      if (profile) {
        const p = profile as {
          oid?: string;
          groups?: string[];
          _claim_names?: { groups?: string };
        };
        token.oid = p.oid;
        token.groups = p.groups;
        // Entra ID's "groups overage": when present, the token omits inline
        // group values and this indirect-claim marker appears instead — the
        // caller must fall back to a Graph membership check (see Task 14).
        token.hasGroupsOverage = p._claim_names?.groups !== undefined;
      }
      return token;
    },
    async session({ session, token }) {
      session.oid = token.oid as string;
      session.groups = token.groups as string[] | undefined;
      session.hasGroupsOverage = token.hasGroupsOverage as boolean;
      return session;
    },
  },
});
