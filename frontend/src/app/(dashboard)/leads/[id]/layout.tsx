export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicLeadLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
