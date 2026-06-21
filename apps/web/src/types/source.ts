/** Read-only source as returned by `GET /sources` (config stripped server-side). */
export interface Source {
  id: string;
  name: string;
  kind: string;
  status?: string;
}
