export function generateStaticParams() {
  return [{ id: '__static' }];
}

export default function DynamicFollowUpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
