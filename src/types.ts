export interface Tab {
  id: string;
  url: string;
  title: string;
}

export interface Account {
  id: string;
  name: string;
  note: string;
  color: string;
  createdAt: number;
  tabs: Tab[];
  activeTabId: string | null;
}

export interface AppState {
  accounts: Account[];
  activeId: string | null;
  activeTabId: string | null;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}
