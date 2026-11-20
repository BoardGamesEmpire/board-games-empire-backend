export interface UserSearchResult {
  firstName: string | null;
  id: string;
  lastName: string | null;

  profile: {
    avatarUrl: string | null;
    displayName: string | null;
  } | null;

  username: string;
}
