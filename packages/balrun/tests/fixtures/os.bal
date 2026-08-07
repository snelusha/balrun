import ballerina/io;
import ballerina/os;

public function main() returns error? {
    check os:setEnv("BALRUN_OS_TEST", "present");
    io:println(os:getEnv("BALRUN_OS_TEST"));
    string? value = os:listEnv()["BALRUN_OS_TEST"];
    io:println(value);
    check os:unsetEnv("BALRUN_OS_TEST");
    io:println(os:getEnv("BALRUN_OS_TEST") == "");
    io:println(os:getUsername().length() > 0);
    io:println(os:getUserHome().length() > 0);

    os:Process process = check os:exec({value: "echo", arguments: ["hello"]});
    io:println(check process.waitForExit());
    io:println(string:fromBytes(check process.output()));
    os:Process|os:Error missing = os:exec({value: "balrun-command-does-not-exist"});
    io:println(missing is os:Error);
}
