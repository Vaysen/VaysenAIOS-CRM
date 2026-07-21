'use client';

import { useEffect } from 'react';

export default function CommunicationPage() {
  useEffect(() => {
    const query = window.location.search || '';
    window.location.replace(`/whatsapp/chat${query}`);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 text-sm text-gray-500 dark:bg-gray-950 dark:text-gray-400">
      Opening communication center...
    </div>
  );
}
