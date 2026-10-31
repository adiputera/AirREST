'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
    showDetails: false,
  };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error('[AirREST ErrorBoundary caught error]:', error, errorInfo);
  }

  private handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      showDetails: false,
    });
    this.props.onReset?.();
  };

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  private toggleDetails = () => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      const title = this.props.fallbackTitle || 'Something went wrong';
      const errorMessage = this.state.error?.message || 'An unexpected rendering error occurred.';

      return (
        <div className="flex flex-1 h-full w-full items-center justify-center p-6 bg-zinc-950 text-zinc-100 select-none">
          <div className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl backdrop-blur-md">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-400">
                <AlertTriangle className="h-6 w-6" />
              </div>

              <div className="flex-1 min-w-0">
                <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
                <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
                  AirREST encountered an unexpected error while displaying this component. Your saved data is intact.
                </p>

                <div className="mt-3 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-3 font-mono text-[11px] text-rose-300 break-words">
                  {errorMessage}
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-5 flex items-center justify-between border-t border-zinc-800/80 pt-4">
              <button
                type="button"
                onClick={this.toggleDetails}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition"
              >
                <span>Technical details</span>
                {this.state.showDetails ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={this.handleReset}
                  className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-800/80 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 hover:text-white transition shadow-sm"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Try Again</span>
                </button>
                <button
                  type="button"
                  onClick={this.handleReload}
                  className="flex items-center gap-1.5 rounded-xl bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-sky-400 transition shadow-lg shadow-sky-500/20"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Reload AirREST</span>
                </button>
              </div>
            </div>

            {/* Collapsible Technical Details */}
            {this.state.showDetails && (
              <div className="mt-4 max-h-48 overflow-y-auto rounded-lg border border-zinc-850 bg-black/60 p-3 text-[10px] font-mono text-zinc-400 space-y-2">
                {this.state.error?.stack && (
                  <div>
                    <div className="text-zinc-300 font-semibold mb-1">Stack Trace:</div>
                    <pre className="whitespace-pre-wrap">{this.state.error.stack}</pre>
                  </div>
                )}
                {this.state.errorInfo?.componentStack && (
                  <div>
                    <div className="text-zinc-300 font-semibold mb-1">Component Stack:</div>
                    <pre className="whitespace-pre-wrap">{this.state.errorInfo.componentStack}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
