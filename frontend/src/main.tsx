import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { App } from "./App";
import "./styles.css";

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
  component: () => <Outlet />
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: App
});

const routeTree = rootRoute.addChildren([indexRoute]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
