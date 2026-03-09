/**
 * Custom Pages Router _document page.
 * Required to prevent Next.js from importing <Html> outside of _document
 * which clashes with the App Router.
 */
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head />
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
