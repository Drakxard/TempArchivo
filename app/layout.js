import "./globals.css";

export const metadata = {
  title: "TempArchivo",
  description: "Un solo slot global para pegar o copiar texto e imagenes.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
