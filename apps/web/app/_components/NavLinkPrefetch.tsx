'use client';

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { useSWRConfig } from 'swr';
import { jsonFetcher } from '../_lib/swr';

export function NavLinkPrefetch({
  href,
  prefetchUrl,
  style,
  className,
  children,
}: {
  href: string;
  prefetchUrl?: string;
  style?: CSSProperties;
  className?: string;
  children: ReactNode;
}) {
  const { mutate, cache } = useSWRConfig();
  const onEnter = () => {
    if (!prefetchUrl) return;
    if (cache.get(prefetchUrl)?.data) return;
    mutate(prefetchUrl, jsonFetcher(prefetchUrl), { revalidate: false }).catch(() => {});
  };
  return (
    <Link
      href={href}
      style={style}
      className={className}
      onMouseEnter={onEnter}
      onFocus={onEnter}
    >
      {children}
    </Link>
  );
}
