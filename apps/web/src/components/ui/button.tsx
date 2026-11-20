import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  tone?: 'primary' | 'quiet';
};

export function Button({ children, className = '', tone = 'primary', ...props }: ButtonProps) {
  return (
    <button className={`button button--${tone} ${className}`.trim()} {...props}>
      {children}
    </button>
  );
}
