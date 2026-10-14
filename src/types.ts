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
  /** true = 名称由登录结果自动识别（用户手动重命名后置 false，不再覆盖） */
  autoName?: boolean;
  /** 自动名称的来源，优先级 uin > login > host：host=站点域名，login=登录页输入的用户名，uin=腾讯云 UIN */
  nameSource?: 'host' | 'login' | 'uin';
  /** 该账号的「首页」：首次打开的站点（⌂ 按钮回到这里；为空则回到起始页） */
  home?: string;
  /** （腾讯云站点专属）当前登录的操作者 UIN（子账号登录时与 ownerUin 不同） */
  uin?: string;
  /** 主账号 UIN */
  ownerUin?: string;
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
  /** 侧边栏是否收起为窄栏 */
  sidebarCollapsed: boolean;
  /** 上次未正常退出且用户尚未选择：渲染层显示「恢复上次会话」内嵌横幅 */
  crashRecovery: boolean;
}

/** 密码条目元数据（不含密文/明文；镜像到主进程供菜单展示） */
export interface CredMeta {
  id: string;
  accountId: string;
  origin: string;
  label: string;
  updatedAt: number;
}

export interface NeverSave {
  accountId: string;
  origin: string;
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
