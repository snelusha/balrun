module ballerina-wasm

go 1.26

replace ballerina-lang-go => ./ballerina/

require ballerina-lang-go v0.0.0-00010101000000-000000000000

require (
	github.com/cockroachdb/apd/v3 v3.2.3 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2 // indirect
	golang.org/x/text v0.28.0 // indirect
)
