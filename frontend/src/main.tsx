/** Starting point: put the app inside <div id="root"> and set up page addresses. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { EndpointDetail } from "./pages/EndpointDetail";
import { Overview } from "./pages/Overview";
import { RunDetail } from "./pages/RunDetail";
import { SuiteDetail } from "./pages/SuiteDetail";
import { Suites } from "./pages/Suites";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      {/* Top navigation, shown on every page. NavLink marks the current section. */}
      <nav className="topnav">
        <span className="brand">Sentinel</span>
        <NavLink to="/" end>
          Websites
        </NavLink>
        <NavLink to="/suites">API tests</NavLink>
      </nav>
      <Routes>
        {/* ":id" is a placeholder: /endpoints/23 shows website 23 */}
        <Route path="/" element={<Overview />} />
        <Route path="/endpoints/:id" element={<EndpointDetail />} />
        <Route path="/suites" element={<Suites />} />
        <Route path="/suites/:id" element={<SuiteDetail />} />
        <Route path="/suites/:id/runs/:runId" element={<RunDetail />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
