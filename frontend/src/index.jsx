import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";
import { ErrorBoundary } from "@/components/shared/ErrorBoundary";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    {/* Outermost net: a crash in a provider (TonConnect, Wallet, Trade) or in
        the shell itself must still show a readable fault instead of an empty
        dark screen. The per-tab boundary in App.jsx is the inner one. */}
    <ErrorBoundary>
      <div className="min-h-screen bg-app-bg">
        <App />
      </div>
    </ErrorBoundary>
  </React.StrictMode>,
);
