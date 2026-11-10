/** Starting point: put the app inside <div id="root"> and set up page addresses. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { EndpointDetail } from "./pages/EndpointDetail";
import { Overview } from "./pages/Overview";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* address "/" shows the Overview page */}
        <Route path="/" element={<Overview />} />
        {/* ":id" is a placeholder: /endpoints/23 shows website 23 */}
        <Route path="/endpoints/:id" element={<EndpointDetail />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
