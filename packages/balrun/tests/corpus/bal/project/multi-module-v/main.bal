import multi_module.greeting;

import ballerina/io;

public function main() {
    io:println(greeting:hello("modules")); // @output Hello, modules!
}
