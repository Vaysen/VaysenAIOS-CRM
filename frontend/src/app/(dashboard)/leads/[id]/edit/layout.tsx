export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicLeadEditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
