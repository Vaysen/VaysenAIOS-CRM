export function generateStaticParams() {
  return [{ id: '__static' }];
}

import ClientPage from './client-page';

export default function ImportPage() {
  return <ClientPage />;
}
