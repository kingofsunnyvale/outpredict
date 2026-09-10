import { createRoot } from "react-dom/client";
import { ProductApp } from "./product";

const root = document.getElementById("root");
if (root) createRoot(root).render(<ProductApp />);
