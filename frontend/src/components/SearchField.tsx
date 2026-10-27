import type { FormEvent } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SearchFieldProps = {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export default function SearchField({ id, label, value, placeholder, onChange, onSubmit }: SearchFieldProps) {
  return (
    <form className="site-search" role="search" onSubmit={onSubmit}>
      <Search size={15} aria-hidden="true" />
      <label className="sr-only" htmlFor={id}>{label}</label>
      <Input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      <Button type="submit" size="sm">搜索</Button>
    </form>
  );
}
