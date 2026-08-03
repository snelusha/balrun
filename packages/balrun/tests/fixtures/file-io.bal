import ballerina/io;

public function main() returns error? {
    check io:fileWriteString("nested/output.txt", "first");
    check io:fileWriteString("nested/output.txt", " second", io:APPEND);
    io:println(check io:fileReadString("nested/output.txt"));
}
