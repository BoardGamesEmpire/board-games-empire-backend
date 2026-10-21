export interface UserSearchResult {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  profile: {
    displayName: string | null;
    avatarUrl: string | null;
  } | null;
}
