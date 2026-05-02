import { useBallerina } from "@snelusha/balrun/react";

export function App() {
	const { run } = useBallerina({ colors: false });

	return (
		<button type="button" onClick={() => void run("./main.bal")}>
			Run Ballerina
		</button>
	);
}
