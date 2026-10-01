if(NOT DEFINED DNG_GENERATOR)
  message(FATAL_ERROR "DNG_GENERATOR is required.")
endif()
if(NOT DEFINED DNG_PROBE)
  message(FATAL_ERROR "DNG_PROBE is required.")
endif()
if(NOT DEFINED DNG_FIXTURE)
  message(FATAL_ERROR "DNG_FIXTURE is required.")
endif()

execute_process(
  COMMAND "${DNG_GENERATOR}" --write-fixture "${DNG_FIXTURE}"
  RESULT_VARIABLE generator_status
  ERROR_VARIABLE generator_error
)
if(NOT generator_status EQUAL 0)
  file(REMOVE "${DNG_FIXTURE}")
  message(
    FATAL_ERROR
    "Unable to generate DNG fixture: ${generator_error}"
  )
endif()

execute_process(
  COMMAND "${DNG_PROBE}" "${DNG_FIXTURE}"
  RESULT_VARIABLE probe_status
  OUTPUT_VARIABLE probe_output
  ERROR_VARIABLE probe_error
  OUTPUT_STRIP_TRAILING_WHITESPACE
)
file(REMOVE "${DNG_FIXTURE}")
if(NOT probe_status EQUAL 0)
  message(
    FATAL_ERROR
    "DNG probe failed (${probe_status}): ${probe_error}\n${probe_output}"
  )
endif()

string(JSON schema_version GET "${probe_output}" schemaVersion)
string(JSON status GET "${probe_output}" status)
string(JSON byte_length GET "${probe_output}" byteLength)
string(JSON width GET "${probe_output}" width)
string(JSON height GET "${probe_output}" height)
string(JSON cfa GET "${probe_output}" cfa)
string(JSON active_width GET "${probe_output}" activeArea width)
string(JSON active_height GET "${probe_output}" activeArea height)
string(JSON orientation GET "${probe_output}" orientation)
string(JSON black_zero GET "${probe_output}" blackLevels 0)
string(JSON white_level GET "${probe_output}" whiteLevel)
string(JSON white_balance_three GET
       "${probe_output}" cameraWhiteBalance 3)

if(NOT schema_version EQUAL 1 OR
   NOT status STREQUAL "ok" OR
   NOT byte_length EQUAL 338 OR
   NOT width EQUAL 6000 OR
   NOT height EQUAL 4000 OR
   NOT cfa STREQUAL "RGGB" OR
   NOT active_width EQUAL 5984 OR
   NOT active_height EQUAL 3984 OR
   NOT orientation EQUAL 1 OR
   NOT black_zero EQUAL 64 OR
   NOT white_level EQUAL 16383 OR
   NOT white_balance_three STREQUAL "1.5")
  message(
    FATAL_ERROR
    "Unexpected DNG probe JSON: ${probe_output}"
  )
endif()
