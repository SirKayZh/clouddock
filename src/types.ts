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

/** 待用户确认的「保存密码」提示（不含密码） */
export interface PendingSave {
  accountId: string;
  /** 用户名展示文本，如「user@example.com」 */
  label: string;
  /** 网站（host[:port]） */
  host: string;
  /** true = 同一用户名已有保存记录，本次是更新密码 */
  update: boolean;
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
  pending: PendingSave | null;
}

/** 页面注入脚本向主进程上报的登录表单内容 */
export interface CapturedLogin {
  fields: string[];
  password: string;
}

/** 主进程回给页面注入脚本的自动填充内容 */
export interface FillPayload {
  fields: string[];
  password: string;
}
