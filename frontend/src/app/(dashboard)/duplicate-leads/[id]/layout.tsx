export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicDuplicateLeadLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
