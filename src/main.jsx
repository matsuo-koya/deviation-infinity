import React from "react";
import { createRoot } from "react-dom/client";
import DeviationEngine from "../DeviationEngine.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DeviationEngine />
  </React.StrictMode>
);
