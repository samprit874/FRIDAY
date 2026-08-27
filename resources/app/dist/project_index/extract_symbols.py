"""
Python AST Symbol Extractor for FRIDAY Code Indexer.
Extracts classes, functions, async functions, methods, and async methods with line numbers and signatures.
"""
import ast
import json
import os
import sys

def extract_symbols_from_source(source_text, filename="<string>"):
    symbols = []
    try:
        tree = ast.parse(source_text, filename=filename)
    except Exception as e:
        return symbols

    class SymbolVisitor(ast.NodeVisitor):
        def __init__(self):
            self.scope_stack = []

        def visit_ClassDef(self, node):
            bases = []
            for b in node.bases:
                if isinstance(b, ast.Name):
                    bases.append(b.id)
                elif isinstance(b, ast.Attribute):
                    bases.append(getattr(b, 'attr', ''))
            
            sig = f"class {node.name}"
            if bases:
                sig += f"({', '.join(filter(None, bases))})"

            parent = self.scope_stack[-1] if self.scope_stack else None
            symbols.append({
                "name": node.name,
                "type": "class",
                "line": node.lineno,
                "parent": parent,
                "signature": sig
            })

            self.scope_stack.append(node.name)
            self.generic_visit(node)
            self.scope_stack.pop()

        def visit_FunctionDef(self, node):
            self._handle_func(node, is_async=False)

        def visit_AsyncFunctionDef(self, node):
            self._handle_func(node, is_async=True)

        def _handle_func(self, node, is_async=False):
            parent = self.scope_stack[-1] if self.scope_stack else None
            if parent:
                sym_type = "async_method" if is_async else "method"
            else:
                sym_type = "async_function" if is_async else "function"

            args = []
            for a in node.args.args:
                args.append(a.arg)
            if node.args.vararg:
                args.append("*" + node.args.vararg.arg)
            if node.args.kwarg:
                args.append("**" + node.args.kwarg.arg)

            prefix = "async def" if is_async else "def"
            sig = f"{prefix} {node.name}({', '.join(args)})"

            symbols.append({
                "name": node.name,
                "type": sym_type,
                "line": node.lineno,
                "parent": parent,
                "signature": sig
            })

            self.scope_stack.append(node.name)
            self.generic_visit(node)
            self.scope_stack.pop()

    visitor = SymbolVisitor()
    visitor.visit(tree)
    return symbols

def process_file(file_path):
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return extract_symbols_from_source(content, filename=file_path)
    except Exception:
        return []

def main():
    if len(sys.argv) < 2:
        # Read from stdin as JSON list of filepaths or single file
        try:
            input_data = sys.stdin.read()
            if not input_data.strip():
                print("[]")
                return
            parsed = json.loads(input_data)
            if isinstance(parsed, list):
                result = {}
                for p in parsed:
                    if os.path.isfile(p):
                        result[p] = process_file(p)
                print(json.dumps(result))
                return
            elif isinstance(parsed, dict) and "source" in parsed:
                syms = extract_symbols_from_source(parsed["source"], parsed.get("filename", "<stdin>"))
                print(json.dumps(syms))
                return
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            return

    target = sys.argv[1]
    if os.path.isfile(target):
        syms = process_file(target)
        print(json.dumps(syms))
    else:
        print("[]")

if __name__ == "__main__":
    main()
