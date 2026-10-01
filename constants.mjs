// 跨文件共享的时间/尺寸常量。
// 内容脚本是普通脚本（不能 import），改动这里的值时请同步：
//   content-scroll-tracker.js 里的 REPORT_INTERVAL_MS（上报间隔）
export const PROGRESS_FLUSH_DELAY_MS = 1000;   // 滚动进度的落盘合并窗口
export const PROGRESS_REPORT_INTERVAL_MS = 400; // 页面侧上报间隔
export const TRACKED_TABS_FLUSH_DELAY_MS = 200;
export const CONTEXT_TTL_MS = 30_000;
export const PANEL_CLOSE_GRACE_MS = 700;       // 关闭面板后等待端口断开的宽限
export const PANEL_CLOSE_FALLBACK_MS = 460;    // 面板收起动画兜底（略大于 panel.css 的 0.42s 宽度过渡）
export const SEARCH_RENDER_DELAY_MS = 180;
export const ROW_PAGE_SIZE = 200;              // 侧边栏一次最多渲染的行数，其余点「显示更多」
export const TOAST_DURATION_MS = 2200;
export const VIEW_STATE_KEY = 'readLaterViewState';
// 收进抽屉的动画：卡片从网页飞到侧边栏边缘所需时间。面板据此推迟新行入场，两边才能接上。
// 内容脚本不能 import，改动时请同步 content-add-animation.js 里的 ARRIVE_MS。
export const ADD_FLIGHT_ARRIVAL_MS = 570;
export const BADGE_FLASH_MS = 1500;            // 侧边栏关着时，工具栏图标「+1」角标停留多久
