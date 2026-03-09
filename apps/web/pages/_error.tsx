/**
 * Custom Pages Router _error page.
 * Required to prevent Next.js from using the default _error which imports
 * <Html> from next/document and clashes with the App Router.
 */
import type { NextPageContext } from 'next';

function ErrorPage({ statusCode }: { statusCode: number }) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <h1 style={{ fontSize: 48 }}>{statusCode}</h1>
      <p>
        {statusCode === 404
          ? 'Page not found.'
          : 'An unexpected error occurred.'}
      </p>
    </div>
  );
}

ErrorPage.getInitialProps = ({ res, err }: NextPageContext) => {
  const statusCode = res ? res.statusCode : err ? (err as { statusCode?: number }).statusCode ?? 500 : 404;
  return { statusCode };
};

export default ErrorPage;
