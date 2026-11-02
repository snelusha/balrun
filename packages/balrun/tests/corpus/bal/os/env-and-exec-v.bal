import ballerina/io;
import ballerina/os;

public function main() returns error? {
    check os:setEnv("BALRUN_OS_TEST", "present");
    io:println(os:getEnv("BALRUN_OS_TEST")); // @output present
    string? value = os:listEnv()["BALRUN_OS_TEST"];
    io:println(value); // @output present
    check os:unsetEnv("BALRUN_OS_TEST");
    io:println(os:getEnv("BALRUN_OS_TEST") == ""); // @output true
    io:println(os:getUsername().length() > 0); // @output true
    io:println(os:getUserHome().length() > 0); // @output true

    os:Process process = check os:exec({value: "echo", arguments: ["hello"]});
    io:println(check process.waitForExit()); // @output 0
    string output = check string:fromBytes(check process.output());
    io:println(output.trim()); // @output hello
    os:Process|os:Error missing = os:exec({value: "balrun-command-does-not-exist"});
    io:println(missing is os:Error); // @output true
}
