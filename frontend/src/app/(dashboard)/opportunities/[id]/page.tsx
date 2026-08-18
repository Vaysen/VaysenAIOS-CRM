import OpportunityDetailPage from './client-page';

export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function OpportunityDetailRoute() { return <OpportunityDetailPage />; }
