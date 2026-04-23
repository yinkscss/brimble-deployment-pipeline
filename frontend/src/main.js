import { jsx as _jsx } from "react/jsx-runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { App } from "./App";
import "./styles.css";
const queryClient = new QueryClient();
const rootRoute = createRootRoute({
    component: () => _jsx(Outlet, {})
});
const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: App
});
const routeTree = rootRoute.addChildren([indexRoute]);
const router = createRouter({ routeTree });
ReactDOM.createRoot(document.getElementById("root")).render(_jsx(React.StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsx(RouterProvider, { router: router }) }) }));
