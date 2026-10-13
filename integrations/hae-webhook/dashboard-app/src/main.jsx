import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { createDashboardClient } from "./client.mjs";
import "./styles.css";
const client = createDashboardClient({
  config: window.__HEALTH_DASHBOARD_CONFIG__,
});
createRoot(document.getElementById("root")).render(
  <App client={client} demo={window.__HEALTH_DASHBOARD_DEMO__ === true}
    reopenUrl={window.__HEALTH_DASHBOARD_CONFIG__?.reopenUrl} />,
);
