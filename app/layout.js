import "./globals.css";
import ServiceWorkerRegister from "./service-worker-register";

export const metadata = {
  title: "TempArchivo",
  description: "Un solo slot global para pegar o copiar texto e imagenes.",
  applicationName: "TempArchivo",
  manifest: "/manifest.json",
  icons: {
    apple: "/icons/apple-touch-icon.png",
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "TempArchivo",
  },
};

export const viewport = {
  themeColor: "#d8c2a2",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
