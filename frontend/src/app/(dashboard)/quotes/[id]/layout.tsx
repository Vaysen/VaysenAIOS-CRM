export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicQuoteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
