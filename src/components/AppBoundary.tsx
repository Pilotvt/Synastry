import React, { type ErrorInfo } from "react";

interface AppBoundaryProps {
  children: React.ReactNode;
}

interface AppBoundaryState {
  error: Error | null;
}

class AppBoundary extends React.Component<AppBoundaryProps, AppBoundaryState> {
  constructor(props: AppBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): AppBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App error boundary:", error, info);
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error.message || String(this.state.error);
      return (
        <div style={{ minHeight: "100vh", background: "#0b1220", color: "#fff", padding: 16 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Произошла ошибка выполнения</h1>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{msg}</pre>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

export default AppBoundary;
