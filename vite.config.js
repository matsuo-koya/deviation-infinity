import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves the project site under /<repo>/.
export default defineConfig({
  base: "/deviation-infinity/",
  plugins: [react()],
});
