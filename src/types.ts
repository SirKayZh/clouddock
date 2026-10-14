export interface Account {
  id: string;
  name: string;
  note: string;
  color: string;
  createdAt: number;
}

export interface AppState {
  accounts: Account[];
  activeId: string | null;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}
