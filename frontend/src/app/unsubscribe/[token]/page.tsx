export function generateStaticParams() {
  return [{ token: '__static' }];
}

import ClientPage from './client-page';

export default function UnsubscribePage() {
  return <ClientPage />;
}
