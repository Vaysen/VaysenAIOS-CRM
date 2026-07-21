export function generateStaticParams() {
  return [{ token: '__static' }];
}

export default function DynamicUnsubscribeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
