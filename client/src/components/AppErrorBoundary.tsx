import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    const fallbackMessage = 'An unexpected UI error occurred.';
    if (error instanceof Error && error.message.trim()) {
      return {
        hasError: true,
        message: error.message.trim(),
      };
    }
    return {
      hasError: true,
      message: fallbackMessage,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Unhandled UI error', { error, componentStack: info.componentStack });
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-app px-4">
        <div className="max-w-lg w-full card border-border bg-bg-card p-6 text-center">
          <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-red-50 border border-red-100 flex items-center justify-center">
            <AlertTriangle className="w-6 h-6 text-red-600" />
          </div>
          <h1 className="text-lg font-bold text-text-primary mb-1">Something went wrong</h1>
          <p className="text-sm text-text-secondary mb-4 break-words">{this.state.message}</p>
          <button
            type="button"
            onClick={this.handleReload}
            className="btn btn-primary w-full py-2 font-bold"
          >
            Reload app
          </button>
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;
