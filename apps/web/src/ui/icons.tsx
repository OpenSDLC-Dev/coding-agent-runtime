// Twilio Paste icons — inner SVG paths (20×20 viewBox, fill="currentColor").
// Verbatim from the design-system bundle (ui_kits/console/icons.js), plus the
// custom geometric "robot" head used as the brand mark + agent avatar.
import type { CSSProperties } from "react";

export type IconName =
  | "accept"
  | "chat"
  | "checkmark-circle"
  | "chevron-disclosure"
  | "close"
  | "delete"
  | "edit"
  | "information"
  | "link-external"
  | "plus"
  | "search"
  | "send"
  | "show"
  | "robot";

const PASTE_ICONS: Record<IconName, string> = {
  accept:
    '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M16.669 6.315c.435.427.442 1.126.016 1.561L9.49 15.22a1.104 1.104 0 01-1.576 0l-3.598-3.663a1.104 1.104 0 111.575-1.546l2.81 2.86 6.407-6.539a1.104 1.104 0 011.56-.016z"></path>',
  chat: '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M3.302 2.755A3.458 3.458 0 015.466 2h2.268a3.468 3.468 0 013.322 2.476.5.5 0 00.959-.286A4.468 4.468 0 007.734 1H5.468a4.458 4.458 0 00-2.2 8.34v3.493a.5.5 0 00.853.353l2.267-2.266a.5.5 0 00-.708-.707l-1.413 1.413V9.037a.5.5 0 00-.286-.452 3.458 3.458 0 01-.68-5.83zm8.965 3.911a4.466 4.466 0 100 8.933h.36l3.253 3.254a.5.5 0 00.853-.354v-3.492A4.459 4.459 0 0019 11.134a4.469 4.469 0 00-4.466-4.468h-2.267zM9.816 8.682a3.466 3.466 0 012.451-1.016h2.267A3.467 3.467 0 0118 11.132a3.459 3.459 0 01-1.98 3.12.5.5 0 00-.287.451v2.589l-2.546-2.546a.5.5 0 00-.353-.147h-.567a3.466 3.466 0 01-2.451-5.917z"></path>',
  "checkmark-circle":
    '<path fill="currentColor" fill-rule="evenodd" d="M12 4a8 8 0 110 16 8 8 0 010-16zm0 1a7 7 0 100 14 7 7 0 000-14zm4.31 3.16a.5.5 0 01.132.627l-.05.075-5.223 6.608a1.2 1.2 0 01-1.867.054l-.077-.103-1.634-2.318a.5.5 0 01.76-.644l.058.068 1.64 2.328a.199.199 0 00.274.056l.029-.023.027-.03 5.229-6.616a.5.5 0 01.702-.082z"></path>',
  "chevron-disclosure":
    '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M9.707 6.293a1 1 0 00-1.497 1.32l.083.094L10.585 10l-2.292 2.293a1 1 0 00-.083 1.32l.083.094a1 1 0 001.32.083l.094-.083 3-3a1 1 0 00.083-1.32l-.083-.094-3-3z"></path>',
  close:
    '<path fill="currentColor" fill-rule="evenodd" d="M15.16 13.514L11.645 10l3.515-3.514a1.165 1.165 0 00-1.646-1.646L10 8.355 6.486 4.84A1.165 1.165 0 004.84 6.486L8.355 10 4.84 13.514a1.165 1.165 0 001.646 1.646L10 11.645l3.514 3.515a1.165 1.165 0 001.646-1.646z"></path>',
  delete:
    '<path fill="currentColor" fill-rule="evenodd" d="M12.25 2c.966 0 1.75.784 1.75 1.75L13.999 5H17.5a.5.5 0 01.09.992L17.5 6h-1.501L16 16.25a1.75 1.75 0 01-1.606 1.744L14.25 18H5.74C4.774 18 4 17.217 4 16.25L3.999 6H2.5a.5.5 0 01-.09-.992L2.5 5h3.499L6 3.75a1.75 1.75 0 011.606-1.744L7.75 2zm2.749 4h-10L5 16.25c0 .383.276.694.64.743l.1.007h8.51a.75.75 0 00.75-.75L14.999 6zM8.5 9a.5.5 0 01.492.41L9 9.5v4a.5.5 0 01-.992.09L8 13.5v-4a.5.5 0 01.5-.5zm3 0a.5.5 0 01.492.41L12 9.5v4a.5.5 0 01-.992.09L11 13.5v-4a.5.5 0 01.5-.5zm.75-6h-4.5a.75.75 0 00-.75.75L6.999 5h6L13 3.75a.75.75 0 00-.648-.743L12.25 3z"></path>',
  edit: '<path fill="currentColor" fill-rule="evenodd" d="M12.345 3.646c.973-.972 2.434-.845 3.646.368 1.21 1.21 1.333 2.662.36 3.636L8.39 15.613a.525.525 0 01-.01.011l-.013.01-.28.28a.515.515 0 01-.157.108l-.091.03-4.081.937a.618.618 0 01-.742-.74l.926-4.089a.515.515 0 01.138-.25l6.84-6.84a.525.525 0 01.01-.01l.009-.008zM4.847 12.82l-.682 3.016 3.007-.69-2.325-2.326zm6.446-6.668l-5.829 5.828 2.549 2.549 5.828-5.829-2.548-2.548zm3.97-1.41c-.836-.836-1.65-.907-2.19-.369l-1.051 1.051 2.548 2.548 1.053-1.051c.48-.482.48-1.171-.11-1.903l-.119-.138z"></path>',
  information:
    '<path fill="currentColor" fill-rule="evenodd" d="M10 2a8 8 0 110 16 8 8 0 010-16zm0 1.25a6.75 6.75 0 100 13.5 6.75 6.75 0 000-13.5zM10 9a1 1 0 011 1v3a1 1 0 01-2 0v-3a1 1 0 011-1zm0-3a1 1 0 110 2 1 1 0 010-2z"></path>',
  "link-external":
    '<path fill="currentColor" fill-rule="evenodd" d="M8.4 4.5a.5.5 0 01.5.5v.1a.5.5 0 01-.5.5H5.6v8.8h8.8v-2.8a.5.5 0 01.41-.492l.09-.008h.1a.5.5 0 01.492.41l.008.09V15a.5.5 0 01-.41.492L15 15.5H5a.5.5 0 01-.492-.41L4.5 15V5a.5.5 0 01.41-.492L5 4.5h3.4zm6.6 0a.5.5 0 01.5.5v.1l-.001.01.001 3.29a.5.5 0 01-.5.5h-.1a.5.5 0 01-.5-.5l-.001-1.935-3.967 3.967a.611.611 0 01-.78.07l-.084-.07a.611.611 0 01-.07-.78l.07-.084L13.534 5.6H11.6a.5.5 0 01-.5-.5V5a.5.5 0 01.5-.5H15z"></path>',
  plus: '<path fill="currentColor" fill-rule="evenodd" d="M15.043 9.043h-4.086V4.957a.958.958 0 00-1.914 0v4.086H4.957a.958.958 0 000 1.914h4.086v4.086a.958.958 0 001.914 0v-4.086h4.086a.958.958 0 000-1.914z"></path>',
  search:
    '<path fill="currentColor" fill-rule="evenodd" d="M5.43 5.43a4.882 4.882 0 017.383 6.347l2.973 2.973a.732.732 0 01-1.036 1.036l-2.973-2.973A4.883 4.883 0 015.43 5.43zm1.035 1.035a3.417 3.417 0 104.833 4.833 3.417 3.417 0 00-4.833-4.833z"></path>',
  send: '<path fill="currentColor" d="M16.999 10.032a.337.337 0 00-.044-.175.274.274 0 00-.123-.114L4.365 4.02a.244.244 0 00-.148-.014.266.266 0 00-.132.075.322.322 0 00-.076.147.355.355 0 00.004.172l1.19 4.46c.004.03.016.056.034.077a.124.124 0 00.067.041l7.054.857a.13.13 0 01.082.052.17.17 0 01.033.101.17.17 0 01-.033.101.13.13 0 01-.082.052l-7.042.87a.124.124 0 00-.067.041.157.157 0 00-.036.077l-1.189 4.46a.355.355 0 00-.008.17.324.324 0 00.072.15.26.26 0 00.13.083c.048.013.1.01.147-.01l12.482-5.644a.28.28 0 00.118-.125.342.342 0 00.034-.181z"></path>',
  show: '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M10.107 4.5c3.252 0 6.477 2.268 8.425 4.41a1.806 1.806 0 01.002 2.424c-1.949 2.145-5.174 4.414-8.427 4.414h-.234c-3.236 0-6.46-2.27-8.405-4.413a1.806 1.806 0 01-.002-2.423C3.436 6.744 6.716 4.463 10 4.5h.004l.104-.001zm-.016 10.123c2.903 0 5.824-2.08 7.609-4.044a.683.683 0 00-.002-.914c-1.783-1.961-4.705-4.04-7.589-4.04H9.889c-2.885 0-5.805 2.079-7.589 4.042a.683.683 0 00.002.914c1.802 1.985 4.763 4.091 7.687 4.041l.102.001zm-.092-7.874H10a3.373 3.373 0 013.373 3.373v.003A3.379 3.379 0 0110 13.498h-.002a3.375 3.375 0 010-6.75zm1.59 4.965c.422-.422.659-.994.66-1.59v-.002A2.249 2.249 0 0010 7.874h-.002a2.25 2.25 0 000 4.5c.597-.002 1.168-.239 1.59-.66z"></path>',
  // Robot-head mark (geometric, filled, currentColor). Eyes are cut as holes via
  // evenodd so the dark avatar background shows through.
  robot:
    '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.7 2.5a1.3 1.3 0 1 1 2.6 0 1.3 1.3 0 0 1-2.6 0ZM9.4 3.4h1.2V5H9.4ZM6.5 5H13.5A3 3 0 0 1 16.5 8V13A3 3 0 0 1 13.5 16H6.5A3 3 0 0 1 3.5 13V8A3 3 0 0 1 6.5 5ZM6.9 8.9h2v2.3h-2ZM11.1 8.9h2v2.3h-2Z"></path>',
};

interface IconProps {
  name: IconName;
  className?: string;
  style?: CSSProperties;
}

// Renders an inlined Paste icon. Inlining (vs <img>) lets the SVG inherit
// `currentColor` from its parent, the way the design system intends.
export function Icon({ name, className = "ic", style }: IconProps) {
  const inner = PASTE_ICONS[name] ?? "";
  return (
    <span
      className={className}
      style={style}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static, build-time icon markup
      dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 20 20" fill="none">${inner}</svg>` }}
    />
  );
}
