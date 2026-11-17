import { Component, type ErrorInfo, type ReactNode } from "react";

import { translate } from "../i18n";

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Shown instead of the children after a render error; the default is a full-page notice with a reload button. */
  fallback?: ReactNode;
  /** What the default notice's button does. */
  onReload?: () => void;
};

type ErrorBoundaryState = { failed: boolean };

/**
 * Keeps one broken component from blanking the whole page: a render error
 * shows a way out (or, with `fallback`, a placeholder for just that part).
 */
export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("界面渲染失败", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    const reload = this.props.onReload ?? (() => window.location.reload());
    return (
      <div className="boot-screen">
        <div className="pub-notice" role="alert">
          <span>{translate("页面遇到了意外错误，请刷新后重试。")}</span>
          <button type="button" onClick={reload}>
            {translate("刷新页面")}
          </button>
        </div>
      </div>
    );
  }
}
