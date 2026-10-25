import Image from "next/image";
import Link from "next/link";

export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Lifeline home">
      <Image
        src="/lifeline-wordmark-dark.png"
        alt="Lifeline"
        width={2000}
        height={528}
        className="brand-wordmark"
        loading="eager"
        unoptimized
      />
    </Link>
  );
}
