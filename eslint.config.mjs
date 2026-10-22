import tseslint from "typescript-eslint";

export default [
	{
		files: ["**/*.{ts,mts,cts}"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": "error",
			"@typescript-eslint/no-floating-promises": "error",
		},
	},
];
